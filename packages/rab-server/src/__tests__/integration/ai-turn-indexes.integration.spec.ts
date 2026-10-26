import './helpers/ai-env';

import { randomUUID } from 'node:crypto';

import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AI_P2_MIGRATION_QUEUED_TURN_CHECKPOINT, AI_P2_MIGRATION_USAGE_TITLE_CALLS } from '../../modules/ai/constants/ai.constants';
import { AiKit, aiOrganisation, ask, bootAiKit, newConversation } from './helpers/ai-test-kit';

/**
 * AI Phase 2 M1 / M2 on the REAL runtime role crewflow_app (T2-5): the database itself allows at most ONE running and ONE
 * queued turn per conversation; the new columns (`checkpointed_at`, `title_source`, `title_calls`) are invisible without
 * a tenant context and to a foreign organisation; the runtime role may update exactly the new columns, never a tenant
 * or owner column; the CHECKs hold.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const pgCode = (e: unknown) => (e as { driverError?: { code?: string }; code?: string })?.driverError?.code ?? (e as { code?: string })?.code;

describeIfDb('AI Phase 2 schema: one running + one queued turn, checkpoint and title columns (integration)', () => {
  jest.setTimeout(300_000);
  let kit: AiKit;
  let tenant: TenantContextService;
  let a: Awaited<ReturnType<typeof aiOrganisation>>;
  let b: Awaited<ReturnType<typeof aiOrganisation>>;

  beforeAll(async () => {
    kit = await bootAiKit();
    tenant = kit.moduleRef.get(TenantContextService);
    a = await aiOrganisation(kit, 'ai-p2-idx-a');
    b = await aiOrganisation(kit, 'ai-p2-idx-b');
  });
  afterAll(async () => {
    await kit?.close();
  });

  const ctxOf = (o: typeof a) => ({ organisationId: o.orgId, workspaceId: o.ceo.workspaceId, userId: o.ceo.userId, role: '' });
  const asTenant = <T>(o: typeof a, sql: string, params: unknown[] = []) => tenant.runInTenantContext(ctxOf(o), (m) => m.query(sql, params) as Promise<T>);

  /** A conversation of `a` with one user question per turn, inserted directly as crewflow_app (RLS + eligibility). */
  async function conversationWithQuestions(n: number): Promise<{ id: string; questions: string[] }> {
    const [conv] = await asTenant<Array<{ id: string }>>(a, `INSERT INTO core.ai_conversation (organisation_id, workspace_id, user_id) VALUES ($1, $2, $3) RETURNING id`, [a.orgId, a.ceo.workspaceId, a.ceo.userId]);
    const questions: string[] = [];
    for (let i = 0; i < n; i++) {
      const [q] = await asTenant<Array<{ id: string }>>(
        a,
        `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, content) VALUES ($1, $2, $3, $4, $5, 'user', 'q') RETURNING id`,
        [a.orgId, a.ceo.workspaceId, a.ceo.userId, conv!.id, 10 + i],
      );
      questions.push(q!.id);
    }
    return { id: conv!.id, questions };
  }
  const insertTurn = (conversationId: string, requestId: string, seq: number, status: string) =>
    asTenant(
      a,
      `INSERT INTO core.ai_message (organisation_id, workspace_id, user_id, conversation_id, seq, role, status, request_message_id, session_id)
       VALUES ($1, $2, $3, $4, $5, 'assistant', $6, $7, $8) RETURNING id`,
      [a.orgId, a.ceo.workspaceId, a.ceo.userId, conversationId, seq, status, requestId, randomUUID()],
    );

  it('migrations are recorded under their constant names', async () => {
    const names = (await kit.owner.query(`SELECT name FROM core.migrations WHERE name = ANY($1::text[])`, [[AI_P2_MIGRATION_QUEUED_TURN_CHECKPOINT, AI_P2_MIGRATION_USAGE_TITLE_CALLS]])).map((r: { name: string }) => r.name).sort();
    expect(names).toEqual([AI_P2_MIGRATION_QUEUED_TURN_CHECKPOINT, AI_P2_MIGRATION_USAGE_TITLE_CALLS].sort());
    const indexes = (await kit.owner.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'core' AND tablename = 'ai_message' AND indexname LIKE 'ai_message_one_%'`)).map((r: { indexname: string }) => r.indexname).sort();
    expect(indexes).toEqual(['ai_message_one_queued_turn', 'ai_message_one_reply', 'ai_message_one_running_turn']);
  });

  it('crewflow_app: a second QUEUED turn in one conversation is refused by the database (23505)', async () => {
    const c = await conversationWithQuestions(2);
    await insertTurn(c.id, c.questions[0]!, 20, 'queued');
    expect(pgCode(await insertTurn(c.id, c.questions[1]!, 21, 'queued').catch((e) => e))).toBe('23505');
  });

  it('crewflow_app: one running + one queued is allowed; a second RUNNING (insert or update) is refused (23505)', async () => {
    const c = await conversationWithQuestions(3);
    await insertTurn(c.id, c.questions[0]!, 20, 'running');
    const [queued] = (await insertTurn(c.id, c.questions[1]!, 21, 'queued')) as Array<{ id: string }>;
    expect(pgCode(await insertTurn(c.id, c.questions[2]!, 22, 'running').catch((e) => e))).toBe('23505');
    expect(pgCode(await asTenant(a, `UPDATE core.ai_message SET status = 'running' WHERE id = $1`, [queued!.id]).catch((e) => e))).toBe('23505');
  });

  it('no tenant context ⇒ zero rows (the new columns included); a foreign organisation sees nothing either', async () => {
    const conversationId = await newConversation(kit, a.token);
    const turn = await ask(kit, a.token, conversationId, 'Index visibility');
    await kit.owner.query(`UPDATE core.ai_message SET checkpointed_at = now() WHERE id = $1`, [turn.turnId]);
    const [{ total }] = await kit.owner.query(`SELECT count(*)::int AS total FROM core.ai_message WHERE checkpointed_at IS NOT NULL`);
    expect(total).toBeGreaterThan(0);
    expect(await kit.runtime.query(`SELECT checkpointed_at FROM core.ai_message WHERE id = $1`, [turn.turnId])).toEqual([]);
    expect(await kit.runtime.query(`SELECT title_source FROM core.ai_conversation WHERE id = $1`, [conversationId])).toEqual([]);
    expect(await kit.runtime.query(`SELECT title_calls FROM core.ai_usage_daily`)).toEqual([]);
    expect(await asTenant(b, `SELECT checkpointed_at FROM core.ai_message WHERE id = $1`, [turn.turnId])).toEqual([]);
    expect(await asTenant(b, `SELECT title_source FROM core.ai_conversation WHERE id = $1`, [conversationId])).toEqual([]);
    // TypeORM returns [rows, rowCount] for an UPDATE: no row matched.
    expect(await asTenant(b, `UPDATE core.ai_conversation SET title_source = 'user' WHERE id = $1 RETURNING id`, [conversationId])).toEqual([[], 0]);
    // The owner sees her own.
    const [own] = await asTenant<Array<{ title_source: string }>>(a, `SELECT title_source FROM core.ai_conversation WHERE id = $1`, [conversationId]);
    expect(own!.title_source).toBe('auto');
  });

  it('grants: the new columns are updatable; tenant/owner columns are not (42501); the CHECKs hold (23514)', async () => {
    const conversationId = await newConversation(kit, a.token);
    const turn = await ask(kit, a.token, conversationId, 'Grant check');
    await asTenant(a, `UPDATE core.ai_message SET checkpointed_at = now() WHERE id = $1`, [turn.turnId]);
    await asTenant(a, `UPDATE core.ai_conversation SET title_source = 'pending' WHERE id = $1`, [conversationId]);
    expect(pgCode(await asTenant(a, `UPDATE core.ai_conversation SET title_source = 'bogus' WHERE id = $1`, [conversationId]).catch((e) => e))).toBe('23514');
    for (const col of ['organisation_id', 'workspace_id', 'user_id', 'conversation_id']) {
      expect(pgCode(await asTenant(a, `UPDATE core.ai_message SET ${col} = ${col} WHERE id = $1`, [turn.turnId]).catch((e) => e))).toBe('42501');
    }
    for (const col of ['organisation_id', 'workspace_id', 'user_id']) {
      expect(pgCode(await asTenant(a, `UPDATE core.ai_conversation SET ${col} = ${col} WHERE id = $1`, [conversationId]).catch((e) => e))).toBe('42501');
    }
    expect(pgCode(await asTenant(a, `DELETE FROM core.ai_message WHERE id = $1`, [turn.turnId]).catch((e) => e))).toBe('42501');
    await asTenant(a, `INSERT INTO core.ai_usage_daily (organisation_id, usage_date, model, title_calls) VALUES ($1, current_date, 'grant-check', 1)
                       ON CONFLICT (organisation_id, usage_date, model) DO UPDATE SET title_calls = core.ai_usage_daily.title_calls + 1`, [a.orgId]);
    expect(pgCode(await asTenant(a, `UPDATE core.ai_usage_daily SET title_calls = -1 WHERE organisation_id = $1 AND model = 'grant-check'`, [a.orgId]).catch((e) => e))).toBe('23514');
    expect(pgCode(await asTenant(a, `UPDATE core.ai_usage_daily SET model = 'x' WHERE organisation_id = $1`, [a.orgId]).catch((e) => e))).toBe('42501');
  });
});
