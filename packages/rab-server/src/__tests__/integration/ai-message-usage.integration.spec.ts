import './helpers/ai-env';

import { EntityManager } from 'typeorm';

import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AiUsageLedgerRow } from '../../modules/ai/contracts/usage';
import { utcDay } from '../../modules/ai/services/ai-quota.service';
import { AiUsageLedgerService } from '../../modules/ai/services/ai-usage-ledger.service';
import { TEST_MOCK_MODEL_ID } from '../support/ai/test-catalogue';
import { scriptedModel, textParts, usage } from './helpers/ai-models';
import { AiKit, aiOrganisation, ask, bearer, bootAiKit, jobFor, manager, newConversation } from './helpers/ai-test-kit';
import { TestIdentity } from './helpers/test-identities';

/**
 * Batch 3 S1 — `usage` + `modelId` per assistant message and `usageTotals` on `GET /ai/conversations/:id`, read from the
 * insert-only `core.ai_usage` ledger as the caller (crewflow_app, FORCE RLS), scripted models only.
 *   - a run turn carries exactly its ledger row (tokens, cached, cache write, output, integer micro-USD, context used/limit)
 *     and the model it ran on; totals are the exact sums;
 *   - a turn with no ledger row: no `usage`, `modelId` null; a conversation with no row at all: no `usageTotals`;
 *   - abuse: another user of the organisation and another organisation get the uniform 404; a ledger row another user
 *     wrote under one of the CEO's turn ids is NOT shown to the CEO (the explicit owner predicate, even though the CEO's
 *     RLS could read it); the API never reads the ledger without a tenant context (zero rows).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

type Who = Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>;

describeIfDb('AI S1: per-message usage and conversation totals (integration)', () => {
  jest.setTimeout(240_000);
  let kit: AiKit;
  let tenant: TenantContextService;
  let ledger: AiUsageLedgerService;

  beforeAll(async () => {
    kit = await bootAiKit();
    tenant = kit.moduleRef.get(TenantContextService);
    ledger = kit.moduleRef.get(AiUsageLedgerService);
  });
  afterEach(() => kit.setModel(null));
  afterAll(async () => {
    await kit?.close();
  });

  const asTenant = <T>(who: Who, fn: (m: EntityManager) => Promise<T>) =>
    tenant.runInTenantContext({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' }, fn);
  const ledgerRow = (who: Who, turnId: string, over: Partial<AiUsageLedgerRow> = {}): AiUsageLedgerRow => ({
    organisationId: who.organisationId,
    userId: who.userId,
    turnId,
    usageDate: utcDay(),
    kind: 'chat',
    model: TEST_MOCK_MODEL_ID,
    steps: 3,
    inputTokens: 12_345,
    cachedInputTokens: 6_000,
    cacheWriteTokens: 1_000,
    outputTokens: 789,
    costUsdMicros: 1_234_567,
    outcome: 'completed',
    contextUsedTokens: 9_999,
    contextLimitTokens: 160_000,
    ...over,
  });
  const detail = (token: string, conversationId: string) => kit.http().get(`/rest/v1/ai/conversations/${conversationId}`).set(bearer(token));

  it('a run turn shows exactly its ledger row and model; a turn without a row shows none; totals are the exact sums', async () => {
    const org = await aiOrganisation(kit, 's1-usage');
    kit.setModel(scriptedModel([textParts('First answer.', usage(40, 7))]).model);
    const conversationId = await newConversation(kit, org.token);
    const first = await ask(kit, org.token, conversationId, 'How many shifts are open?');
    expect(await kit.runner.run(jobFor(org.ceo, conversationId, first.turnId))).toBe('completed');
    const [written] = await kit.owner.query(
      `SELECT model, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, cost_usd_micros, context_used_tokens, context_limit_tokens
         FROM core.ai_usage WHERE turn_id = $1`,
      [first.turnId],
    );
    expect(written).toBeDefined();

    // A second turn, never run: no ledger row yet → no usage, no model.
    const second = await ask(kit, org.token, conversationId, 'And tomorrow?');
    let res = await detail(org.token, conversationId);
    expect(res.status).toBe(200);
    const msg = (id: string) => (res.body.messages as Array<Record<string, unknown>>).find((x) => x.id === id)!;
    const firstUsage = {
      inputTokens: Number(written.input_tokens),
      cachedInputTokens: Number(written.cached_input_tokens),
      cacheWriteTokens: Number(written.cache_write_tokens),
      outputTokens: Number(written.output_tokens),
      costUsdMicros: Number(written.cost_usd_micros),
      contextUsedTokens: Number(written.context_used_tokens),
      contextLimitTokens: Number(written.context_limit_tokens),
    };
    expect(msg(first.turnId).usage).toEqual(firstUsage);
    expect(msg(first.turnId).usage).toMatchObject({ inputTokens: 40, outputTokens: 7 });
    expect(msg(first.turnId).modelId).toBe(written.model);
    expect(msg(second.turnId)).not.toHaveProperty('usage');
    expect(msg(second.turnId).modelId).toBeNull();
    for (const m of (res.body.messages as Array<Record<string, unknown>>).filter((x) => x.role === 'user')) {
      expect(m).not.toHaveProperty('usage');
      expect(m.modelId).toBeNull();
    }
    expect(res.body.usageTotals).toEqual({ turns: 1, ...Object.fromEntries(Object.entries(firstUsage).filter(([k]) => !k.startsWith('context'))) });

    // The ledger row of the second turn (what the 7b runner writes at its terminal transition): exact integers, summed.
    expect(await asTenant(org.ceo, (m) => ledger.insertTerminal(m, ledgerRow(org.ceo, second.turnId)))).toBe(true);
    res = await detail(org.token, conversationId);
    expect(msg(second.turnId).usage).toEqual({
      inputTokens: 12_345,
      cachedInputTokens: 6_000,
      cacheWriteTokens: 1_000,
      outputTokens: 789,
      costUsdMicros: 1_234_567,
      contextUsedTokens: 9_999,
      contextLimitTokens: 160_000,
    });
    expect(msg(second.turnId).modelId).toBe(TEST_MOCK_MODEL_ID);
    expect(res.body.usageTotals).toEqual({
      turns: 2,
      inputTokens: firstUsage.inputTokens + 12_345,
      cachedInputTokens: firstUsage.cachedInputTokens + 6_000,
      cacheWriteTokens: firstUsage.cacheWriteTokens + 1_000,
      outputTokens: firstUsage.outputTokens + 789,
      costUsdMicros: firstUsage.costUsdMicros + 1_234_567,
    });
    expect(Number.isInteger(res.body.usageTotals.costUsdMicros)).toBe(true);
  });

  it('a conversation with no ledger row has no usageTotals', async () => {
    const org = await aiOrganisation(kit, 's1-none');
    const conversationId = await newConversation(kit, org.token);
    await ask(kit, org.token, conversationId, 'Queued only.');
    const res = await detail(org.token, conversationId);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('usageTotals');
  });

  it('abuse: another user of the organisation and another organisation get the uniform 404 (no usage disclosed)', async () => {
    const org = await aiOrganisation(kit, 's1-owner');
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Mine.');
    await asTenant(org.ceo, (m) => ledger.insertTerminal(m, ledgerRow(org.ceo, turn.turnId)));
    const im = await manager(kit, org.orgId, { initial: true });
    const other = await detail(im.token, conversationId);
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain('1234567');
    const foreign = await aiOrganisation(kit, 's1-foreign');
    const res = await detail(foreign.token, conversationId);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('1234567');
  });

  it("abuse: a ledger row another user wrote under the CEO's turn id is never shown (explicit owner predicate)", async () => {
    const org = await aiOrganisation(kit, 's1-forged');
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Whose usage?');
    const im = await manager(kit, org.orgId, { initial: true });
    // The ledger has no FK to the turn (by design); RLS lets a user insert rows for THEMSELVES only. The CEO's RLS
    // could read this row (the CEO reads the organisation), so only the service's `user_id` predicate keeps it out.
    expect(await asTenant(im.id, (m) => ledger.insertTerminal(m, ledgerRow(im.id, turn.turnId, { costUsdMicros: 777_777 })))).toBe(true);
    const visibleToCeo = await asTenant(org.ceo, (m) => m.query(`SELECT 1 FROM core.ai_usage WHERE turn_id = $1`, [turn.turnId]));
    expect(visibleToCeo).toHaveLength(1);
    const res = await detail(org.token, conversationId);
    expect(res.status).toBe(200);
    const msg = (res.body.messages as Array<Record<string, unknown>>).find((x) => x.id === turn.turnId)!;
    expect(msg).not.toHaveProperty('usage');
    expect(msg.modelId).toBeNull();
    expect(res.body).not.toHaveProperty('usageTotals');
    expect(JSON.stringify(res.body)).not.toContain('777777');
  });

  it('no tenant context bound: the ledger read returns zero rows (fail closed)', async () => {
    const org = await aiOrganisation(kit, 's1-nocontext');
    const conversationId = await newConversation(kit, org.token);
    const turn = await ask(kit, org.token, conversationId, 'Context?');
    await asTenant(org.ceo, (m) => ledger.insertTerminal(m, ledgerRow(org.ceo, turn.turnId)));
    const rows = await kit.runtime.transaction((m) => m.query(`SELECT turn_id FROM core.ai_usage WHERE turn_id = $1`, [turn.turnId]));
    expect(rows).toEqual([]);
  });
});
