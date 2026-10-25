import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, manager, newConversation } from './helpers/ai-test-kit';

/**
 * AI Phase 1 — PostgreSQL isolation (brief §15 "PostgreSQL/RLS"), proven on the REAL runtime role crewflow_app:
 * zero rows without context, organisation and user isolation (HTTP + raw RLS), forged ids, composite tenant FKs,
 * eligibility WITH CHECK, the platform-admin-only organisation switch, least-privilege grants, the inert proposal table.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const TABLES = ['ai_conversation', 'ai_message', 'ai_usage_daily', 'ai_action_proposal', 'organisation_ai_setting'];

describeIfDb('AI tables RLS and grants (integration)', () => {
  jest.setTimeout(180_000);
  let kit: AiKit;
  let tenant: TenantContextService;
  let a: Awaited<ReturnType<typeof aiOrganisation>> & { conversationId: string; turnId: string };
  let b: Awaited<ReturnType<typeof aiOrganisation>>;

  beforeAll(async () => {
    kit = await bootAiKit();
    tenant = kit.moduleRef.get(TenantContextService);
    const orgA = await aiOrganisation(kit, 'ai-rls-a');
    const conversationId = await newConversation(kit, orgA.token);
    const turn = await ask(kit, orgA.token, conversationId, 'How many offers are awaiting replies?');
    expect(turn.status).toBe(202);
    a = { ...orgA, conversationId, turnId: turn.turnId };
    b = await aiOrganisation(kit, 'ai-rls-b');
  });
  afterAll(async () => {
    await kit?.close();
  });

  const asTenant = <T>(ctx: { organisationId: string; workspaceId: string | null; userId: string }, sql: string, params: unknown[] = []) =>
    tenant.runInTenantContext({ ...ctx, role: '' }, (m) => m.query(sql, params) as Promise<T>);

  it('the runtime connection is crewflow_app (no BYPASSRLS) — the role the API and the Worker step loop use', async () => {
    const [row] = await kit.runtime.query(`SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`);
    expect(row).toEqual({ u: 'crewflow_app', bypass: false });
  });

  it('no tenant context bound ⇒ zero rows from every AI table (fail closed), although rows exist', async () => {
    for (const t of TABLES) {
      const [{ total }] = await kit.owner.query(`SELECT count(*)::int AS total FROM core.${t}`);
      if (t !== 'ai_action_proposal') expect(total).toBeGreaterThan(0);
      const [{ n }] = await kit.runtime.query(`SELECT count(*)::int AS n FROM core.${t}`);
      expect({ t, n }).toEqual({ t, n: 0 });
    }
  });

  it('organisation B cannot read A’s conversation: HTTP 404 on every route, and RLS returns nothing for B’s context', async () => {
    for (const [method, url] of [
      ['get', `/rest/v1/ai/conversations/${a.conversationId}`],
      ['delete', `/rest/v1/ai/conversations/${a.conversationId}`],
      ['get', `/rest/v1/ai/conversations/${a.conversationId}/stream?turnId=${a.turnId}`],
      ['post', `/rest/v1/ai/conversations/${a.conversationId}/turns/${a.turnId}/cancel`],
      ['post', `/rest/v1/ai/conversations/${a.conversationId}/messages`],
    ] as const) {
      const req = kit.http()[method](url).set(bearer(b.token));
      const res = method === 'post' ? await req.send(url.endsWith('messages') ? { content: 'leak?', clientRequestId: randomUUID() } : {}) : await req;
      expect({ url, status: res.status }).toEqual({ url, status: 404 });
      expect(JSON.stringify(res.body)).not.toContain(a.conversationId);
    }
    expect((await kit.http().get('/rest/v1/ai/conversations').set(bearer(b.token))).body.data).toEqual([]);
    const rows = await asTenant<unknown[]>({ organisationId: b.ceo.organisationId, workspaceId: b.ceo.workspaceId, userId: b.ceo.userId }, `SELECT id FROM core.ai_message WHERE conversation_id = $1`, [a.conversationId]);
    expect(rows).toEqual([]);
    // Forging A's organisation in B's session context does not help either: the user predicate still fails.
    const forged = await asTenant<unknown[]>({ organisationId: a.ceo.organisationId, workspaceId: a.ceo.workspaceId, userId: b.ceo.userId }, `SELECT id FROM core.ai_conversation`);
    expect(forged).toEqual([]);
    expect((await kit.owner.query(`SELECT count(*)::int AS n FROM core.ai_conversation WHERE id = $1`, [a.conversationId]))[0].n).toBe(1);
  });

  it('another user of the SAME organisation (the Initial Manager) cannot see the CEO’s conversation', async () => {
    const im = await manager(kit, a.orgId, { initial: true });
    expect((await kit.http().get(`/rest/v1/ai/conversations/${a.conversationId}`).set(bearer(im.token))).status).toBe(404);
    expect((await kit.http().get('/rest/v1/ai/conversations').set(bearer(im.token))).body.data).toEqual([]);
    const rows = await asTenant<unknown[]>({ organisationId: a.orgId, workspaceId: a.ceo.workspaceId, userId: im.id.userId }, `SELECT id FROM core.ai_conversation`);
    expect(rows).toEqual([]);
  });

  it('a malformed id is a 404 before any query; a random id is a 404 indistinguishable from a foreign one', async () => {
    expect((await kit.http().get('/rest/v1/ai/conversations/not-a-uuid').set(bearer(a.token))).status).toBe(404);
    const random = await kit.http().get(`/rest/v1/ai/conversations/${randomUUID()}`).set(bearer(a.token));
    const foreign = await kit.http().get(`/rest/v1/ai/conversations/${a.conversationId}`).set(bearer(b.token));
    expect(random.status).toBe(404);
    expect(random.body).toEqual(foreign.body);
  });

  it('composite tenant FKs: a message can never reference another organisation’s or another user’s conversation (even as the owner)', async () => {
    const attempt = (org: string, ws: string, user: string) =>
      kit.owner.query(
        `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, content) VALUES ($1, $2, $3, $4, 199, 'user', 'x')`,
        [org, ws, user, a.conversationId],
      );
    await expect(attempt(b.orgId, b.ceo.workspaceId!, b.ceo.userId)).rejects.toMatchObject({ code: '23503' });
    await expect(attempt(a.orgId, a.ceo.workspaceId!, b.ceo.userId)).rejects.toMatchObject({ code: '23503' });
    await expect(attempt(a.orgId, b.ceo.workspaceId!, a.ceo.userId)).rejects.toMatchObject({ code: '23503' });
    await expect(
      kit.owner.query(`INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id) VALUES ($1, $2, $3)`, [a.orgId, b.ceo.workspaceId, a.ceo.userId]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('WITH CHECK: crewflow_app cannot insert a row for another tenant/user, and an ineligible user cannot insert at all', async () => {
    const ctxA = { organisationId: a.orgId, workspaceId: a.ceo.workspaceId, userId: a.ceo.userId };
    await expect(asTenant(ctxA, `INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id) VALUES ($1, $2, $3)`, [b.orgId, b.ceo.workspaceId, b.ceo.userId])).rejects.toMatchObject({ code: '42501' });
    const other = await manager(kit, a.orgId); // holds ai.use through the manager role, but is not the Initial Manager
    await expect(
      asTenant({ organisationId: a.orgId, workspaceId: other.id.workspaceId, userId: other.id.userId }, `INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id) VALUES ($1, $2, $3)`, [a.orgId, other.id.workspaceId, other.id.userId]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the organisation AI switch: a tenant (even the CEO) cannot turn it on; only an active platform administrator can (RLS)', async () => {
    const ctxB = { organisationId: b.orgId, workspaceId: b.ceo.workspaceId, userId: b.ceo.userId };
    // TypeORM returns [rows, affected] for an UPDATE: the row is visible to B but the write policy matches nothing.
    await expect(asTenant(ctxB, `UPDATE core.organisation_ai_setting SET enabled = false WHERE organisation_id = $1 RETURNING 1`, [b.orgId])).resolves.toEqual([[], 0]);
    const fresh = await kit.factory.createOrganisation('ai-rls-switch');
    const ceo = await kit.factory.createCeo(fresh, { permissions: 'production' });
    await expect(
      asTenant({ organisationId: fresh.id, workspaceId: ceo.workspaceId, userId: ceo.userId }, `INSERT INTO core.organisation_ai_setting (organisation_id, enabled) VALUES ($1, true)`, [fresh.id]),
    ).rejects.toMatchObject({ code: '42501' });
    const admin = await kit.factory.createCeo(await kit.factory.createOrganisation('ai-rls-admin'), { platformAdmin: true });
    await expect(
      asTenant({ organisationId: fresh.id, workspaceId: null, userId: admin.userId }, `INSERT INTO core.organisation_ai_setting (organisation_id, enabled) VALUES ($1, true) RETURNING enabled`, [fresh.id]),
    ).resolves.toEqual([{ enabled: true }]);
  });

  it('least privilege: no DELETE on messages/usage, no TRUNCATE, no write on the inert proposal table, no tenant-column UPDATE', async () => {
    const ctxA = { organisationId: a.orgId, workspaceId: a.ceo.workspaceId, userId: a.ceo.userId };
    for (const sql of [
      `DELETE FROM core.ai_message WHERE conversation_id = '${a.conversationId}'`,
      `DELETE FROM core.ai_usage_daily`,
      `TRUNCATE core.ai_conversation`,
      `INSERT INTO core.ai_action_proposal (organisation_id, workspace_id, user_id, conversation_id, tool, arguments, summary, expires_at) VALUES ('${a.orgId}', '${a.ceo.workspaceId}', '${a.ceo.userId}', '${a.conversationId}', 'send_offers', '{}', 'x', now())`,
      `UPDATE core.ai_message SET organisation_id = '${b.orgId}' WHERE conversation_id = '${a.conversationId}'`,
      `UPDATE core.ai_conversation SET user_id = '${b.ceo.userId}' WHERE id = '${a.conversationId}'`,
    ]) {
      await expect(asTenant(ctxA, sql)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('the purge function refuses a retention below its 30-day SQL floor and an out-of-range batch (whatever the caller passes)', async () => {
    const ctxA = { organisationId: a.orgId, workspaceId: null, userId: '' };
    for (const interval of ['0', '1 day', '29 days']) {
      await expect(asTenant(ctxA, `SELECT core.ai_purge_expired_conversations(interval '${interval}', 10, false)`)).rejects.toMatchObject({ code: '22023' });
    }
    await expect(asTenant(ctxA, `SELECT core.ai_purge_expired_conversations(interval '90 days', 0, false)`)).rejects.toMatchObject({ code: '22023' });
    await expect(asTenant(ctxA, `SELECT core.ai_purge_expired_conversations(interval '90 days', 1001, false)`)).rejects.toMatchObject({ code: '22023' });
    // No organisation bound ⇒ nothing (0), never "every organisation".
    await expect(kit.runtime.query(`SELECT core.ai_purge_expired_conversations(interval '90 days', 10, false) AS n`)).resolves.toEqual([{ n: 0 }]);
  });

  it('the admin usage function: 42501 for anyone but an active platform administrator (unbound, tenant CEO)', async () => {
    await expect(kit.runtime.query(`SELECT * FROM core.ai_admin_usage_summary(current_date, current_date, 10)`)).rejects.toMatchObject({ code: '42501' });
    await expect(asTenant({ organisationId: a.orgId, workspaceId: a.ceo.workspaceId, userId: a.ceo.userId }, `SELECT * FROM core.ai_admin_usage_summary(current_date, current_date, 10)`)).rejects.toMatchObject({ code: '42501' });
  });
});
