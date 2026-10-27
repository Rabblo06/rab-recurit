import './helpers/ai-env';

import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { AI_QUEUE_NAME, aiTitleJobId } from '../../engine/worker-shared/ai-queue.constants';
import { AiConfigService } from '../../modules/ai/services/ai-config.service';
import { AiQuotaService, utcDay } from '../../modules/ai/services/ai-quota.service';
import { AiStreamService } from '../../modules/ai/services/ai-stream.service';
import { AiTitleService } from '../../modules/ai/services/ai-title.service';
import { titleJobData } from '../../modules/ai/services/ai-turn-queue.service';
import { scriptedModel, textParts } from './helpers/ai-models';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, newConversation, setOrgAi } from './helpers/ai-test-kit';

/**
 * AI Phase 2 — thread titles in the Worker (docs/ai/PHASE2_TWENTY_PLAN.md §2.5, P2-C9; T2-11): generated once, from the
 * first message only, through the gateway, billed (`title_calls`, tokens, `turns` unchanged), sanitised, never over a
 * user title, refused (no model call) when the budget is spent or access is gone, IDs-only job. Scripted models only.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('AI thread titles (integration)', () => {
  jest.setTimeout(180_000);
  let kit: AiKit;
  let titles: AiTitleService;
  let quota: AiQuotaService;
  let streams: AiStreamService;
  let jobs: Queue;
  let connection: Redis;

  beforeAll(async () => {
    kit = await bootAiKit();
    titles = kit.moduleRef.get(AiTitleService);
    quota = kit.moduleRef.get(AiQuotaService);
    streams = kit.moduleRef.get(AiStreamService);
    connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    jobs = new Queue(AI_QUEUE_NAME, { connection });
  });
  afterEach(() => {
    kit.setModel(null);
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await jobs?.close();
    await connection?.quit();
    await kit?.close();
  });

  const conversationRow = async (id: string) => (await kit.owner.query(`SELECT title, title_source FROM core.ai_conversation WHERE id = $1`, [id]))[0];
  const usageRow = async (orgId: string) =>
    (await kit.owner.query(`SELECT turns, title_calls, input_tokens::int AS input, output_tokens::int AS output FROM core.ai_usage_daily WHERE organisation_id = $1 AND usage_date = $2::date`, [orgId, utcDay()]))[0];
  const budgetUse = async (orgId: string) => Number((await kit.redis.get(quota.budgetKey(orgId, utcDay()))) ?? 0);

  async function firstQuestion(label: string, question: string) {
    const org = await aiOrganisation(kit, label);
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, question);
    expect(turn.status).toBe(202);
    const job = await jobs.getJob(aiTitleJobId(conversationId));
    return { org, conversationId, turnId: turn.turnId, job };
  }

  it('the first question enqueues ONE ids-only title job; the title is written as `model`, once, from the first message only, and billed as a title', async () => {
    const t = await firstQuestion('ai-title-ok', 'Which shifts still need staff this weekend?');
    expect(t.job).toBeTruthy();
    expect(t.job!.name).toBe('ai-title');
    expect(Object.keys(t.job!.data).sort()).toEqual(['conversationId', 'kind', 'organisationId', 'turnId', 'userId', 'v', 'workspaceId']);
    expect(t.job!.data).toMatchObject({ v: 2, kind: 'title', conversationId: t.conversationId, turnId: t.turnId });
    expect(await conversationRow(t.conversationId)).toMatchObject({ title_source: 'auto', title: 'Which shifts still need staff this weekend?' });

    const scripted = scriptedModel([textParts('Weekend unfilled shifts')]);
    kit.setModel(scripted.model);
    const before = await budgetUse(t.org.orgId);
    expect(await titles.run(t.job!.data)).toBe('written');
    expect(await conversationRow(t.conversationId)).toEqual({ title: 'Weekend unfilled shifts', title_source: 'model' });
    // One call, no tools, the first message only, inside <data>.
    expect(scripted.seen).toHaveLength(1);
    expect(scripted.seen[0]!.tools ?? []).toEqual([]);
    const userMessages = scripted.seen[0]!.prompt.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(JSON.stringify(userMessages[0])).toMatch(/<data>\\nWhich shifts still need staff this weekend\?\\n<\/data>/);
    // Billed: title_calls = 1, tokens counted, `turns` unchanged (the turn itself has not run); budget settled to actual.
    expect(await usageRow(t.org.orgId)).toMatchObject({ turns: 0, title_calls: 1, input: 10, output: 5 });
    expect((await budgetUse(t.org.orgId)) - before).toBe(15);
    const audit = await kit.owner.query(`SELECT metadata FROM core.audit_log WHERE action = 'ai.title_generated' AND entity_id = $1`, [t.conversationId]);
    expect(audit).toEqual([{ metadata: { model: 'crewflow-mock-1', tokens: 15 } }]);
    // Published as a `title` event on the (still open) turn stream; plain text.
    const events = await streams.read(t.conversationId, t.turnId, '0-0', 50);
    expect(events.map((e) => e.event)).toContainEqual({ type: 'title', turnId: t.turnId, title: 'Weekend unfilled shifts' });
    // Never again: a second delivery is skipped without a model call.
    expect(await titles.run(t.job!.data)).toBe('skipped');
    expect(scripted.seen).toHaveLength(1);
  });

  it('a title the user typed is never regenerated (no job; a forged job is skipped, no model call)', async () => {
    const org = await aiOrganisation(kit, 'ai-title-user');
    const created = await kit.http().post('/rest/v1/ai/conversations').set(bearer(org.token)).send({ title: 'My own title' });
    expect(created.status).toBe(201);
    const turn = await ask(kit, org.token, created.body.id, 'Anything at all');
    expect(await jobs.getJob(aiTitleJobId(created.body.id))).toBeFalsy();
    const scripted = scriptedModel([textParts('Model title')]);
    kit.setModel(scripted.model);
    const forged = titleJobData({ turnId: turn.turnId, conversationId: created.body.id, organisationId: org.orgId, workspaceId: org.ceo.workspaceId!, userId: org.ceo.userId });
    expect(await titles.run(forged)).toBe('skipped');
    expect(scripted.seen).toHaveLength(0);
    expect(await conversationRow(created.body.id)).toEqual({ title: 'My own title', title_source: 'user' });
  });

  it('the output is sanitised: one line, no Markdown, emails / numbers masked, ≤ 120 characters', async () => {
    const t = await firstQuestion('ai-title-sanitise', 'Plan for next week');
    kit.setModel(scriptedModel([textParts(`Title: **Shift** plan\nfor bob@corp.example.com ${'x'.repeat(30)} ${'word '.repeat(40)}`)]).model);
    expect(await titles.run(t.job!.data)).toBe('written');
    const { title } = await conversationRow(t.conversationId);
    expect(title).not.toMatch(/[\n*#`]/);
    expect(title).not.toContain('bob@corp.example.com');
    expect(title).toMatch(/^Shift plan for \[?email removed/);
    expect(title.length).toBeLessThanOrEqual(120);
  });

  it('budget spent ⇒ no model call; the fallback title stays and the state returns to `auto`', async () => {
    const t = await firstQuestion('ai-title-budget', 'Budget question');
    const config = kit.moduleRef.get(AiConfigService);
    await kit.redis.set(quota.budgetKey(t.org.orgId, utcDay()), String(config.orgDailyTokenBudget), 'EX', 3600);
    const scripted = scriptedModel([textParts('Never')]);
    kit.setModel(scripted.model);
    expect(await titles.run(t.job!.data)).toBe('skipped');
    expect(scripted.seen).toHaveLength(0);
    expect(await conversationRow(t.conversationId)).toEqual({ title: 'Budget question', title_source: 'auto' });
  });

  it('organisation switch off / ai.use removed ⇒ refused before any model call, audited with codes only', async () => {
    for (const revoke of ['organisation_disabled', 'permission'] as const) {
      const t = await firstQuestion(`ai-title-${revoke}`, 'Secret plans for Alice');
      if (revoke === 'organisation_disabled') await setOrgAi(kit, t.org.orgId, false);
      else
        await kit.owner.query(`INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = 'ai.use'`, [
          t.org.ceo.userId,
          t.org.orgId,
        ]);
      const scripted = scriptedModel([textParts('Never')]);
      kit.setModel(scripted.model);
      expect(await titles.run(t.job!.data)).toBe('refused');
      expect(scripted.seen).toHaveLength(0);
      expect((await conversationRow(t.conversationId)).title_source).toBe('auto');
      const [audit] = await kit.owner.query(`SELECT metadata FROM core.audit_log WHERE action = 'ai.turn_refused' AND entity_id = $1`, [t.conversationId]);
      expect(audit.metadata).toEqual({ reason: revoke, stage: 'title' });
      expect(JSON.stringify(audit)).not.toContain('Alice');
    }
  });

  it('AI_TITLE_GENERATION off ⇒ a queued title job does nothing; a malformed or mismatched job is skipped', async () => {
    const t = await firstQuestion('ai-title-off', 'Switch question');
    const scripted = scriptedModel([textParts('Never')]);
    kit.setModel(scripted.model);
    jest.spyOn(titles, 'enabled', 'get').mockReturnValue(false);
    expect(await titles.run(t.job!.data)).toBe('skipped');
    jest.restoreAllMocks();
    expect(await titles.run({ ...t.job!.data, kind: 'turn' })).toBe('skipped');
    expect(await titles.run({ ...t.job!.data, v: 1 })).toBe('skipped');
    expect(await titles.run(null)).toBe('skipped');
    expect(scripted.seen).toHaveLength(0);
  });
});
